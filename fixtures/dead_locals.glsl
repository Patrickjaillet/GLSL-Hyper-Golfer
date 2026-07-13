void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    float unusedLiteral = 1.0;
    float unusedNoInit;
    float unusedCall = length(fragCoord);
    float unusedArray[3];

    float p = 2.0;
    float unusedBetween = 3.0;
    float q = 4.0;

    float used = 5.0;
    float alsoUsed = used;

    if (fragCoord.x > 0.0)
    {
        float deadInBranch = 6.0;
    }

    fragColor = vec4(p + q + alsoUsed, 0.0, 0.0, 1.0);
}
